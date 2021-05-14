import { CfnStage, HttpApi, VpcLink } from "@aws-cdk/aws-apigatewayv2";
import { HttpServiceDiscoveryIntegration } from "@aws-cdk/aws-apigatewayv2-integrations";
import {
  CfnUserPoolIdentityProvider,
  OAuthScope,
  UserPool,
  UserPoolClientIdentityProvider,
  UserPoolDomain,
} from "@aws-cdk/aws-cognito";
import {
  InterfaceVpcEndpoint,
  InterfaceVpcEndpointAwsService,
  IVpc,
  Peer,
  Port,
  SecurityGroup,
  SubnetType,
  Vpc,
} from "@aws-cdk/aws-ec2";
import {
  AwsLogDriver,
  Cluster,
  ContainerImage,
  FargateService,
  FargateTaskDefinition,
} from "@aws-cdk/aws-ecs";
import { LogGroup } from "@aws-cdk/aws-logs";
import {
  DnsRecordType,
  IService,
  PrivateDnsNamespace,
  Service,
} from "@aws-cdk/aws-servicediscovery";
import * as cdk from "@aws-cdk/core";
import { resolve } from "path";

interface ProviderMap {
  [name: string]: {
    url: string;
    service: FargateService;
  };
}

const PROVIDER_NAMES = ["First", "Second"];

export class CognitoTwoSamlProvidersPocStack extends cdk.Stack {
  private vpc: IVpc;
  private up: UserPool;
  private domain: UserPoolDomain;
  private providers: ProviderMap;

  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    this.createVpc();
    this.createUserPool();
    this.createSamlProviders();
    this.registerSamlProviders();
  }

  private registerSamlProviders() {
    const providers = [];
    for (const name of PROVIDER_NAMES) {
      const provider = new CfnUserPoolIdentityProvider(
        this,
        `Cognito${name}SamlIdp`,
        {
          providerName: name,
          providerType: "SAML",
          userPoolId: this.up.userPoolId,
          providerDetails: {
            MetadataURL:
              this.providers[name].url +
              "auth/realms/test/protocol/saml/descriptor",
          },
        }
      );
      providers.push(provider);
      provider.node.addDependency(this.providers[name].service);
      const client = this.up.addClient(`Cognito${name}AppClient`, {
        oAuth: {
          flows: {
            implicitCodeGrant: true,
          },
          callbackUrls: ["https://jwt.io"],
          scopes: [OAuthScope.OPENID],
        },
        generateSecret: false,
        supportedIdentityProviders: [
          UserPoolClientIdentityProvider.custom(name),
        ],
      });
      client.node.addDependency(provider);
      new cdk.CfnOutput(this, "AuthorizeUrlFor" + name, {
        value: `${this.domain.baseUrl()}/authorize?client_id=${
          client.userPoolClientId
        }&response_type=token&scope=openid&redirect_uri=https://jwt.io`,
      });
    }

    let client = this.up.addClient(`CognitoAppClientForAll`, {
      oAuth: {
        flows: {
          implicitCodeGrant: true,
        },
        callbackUrls: ["https://jwt.io"],
        scopes: [OAuthScope.OPENID],
      },
      generateSecret: false,
      supportedIdentityProviders: PROVIDER_NAMES.map((name) =>
        UserPoolClientIdentityProvider.custom(name)
      ),
    });
    client.node.addDependency(...providers);
    new cdk.CfnOutput(this, "AuthorizeUrlAll", {
      value: `${this.domain.baseUrl()}/authorize?client_id=${
        client.userPoolClientId
      }&response_type=token&scope=openid&redirect_uri=https://jwt.io`,
    });
    new cdk.CfnOutput(this, "AuthorizeUrlWithExplicitChoice", {
      value: `${this.domain.baseUrl()}/authorize?client_id=${
        client.userPoolClientId
      }&response_type=token&scope=openid&redirect_uri=https://jwt.io&identity_provider=${
        PROVIDER_NAMES[0]
      }`,
    });

    client = this.up.addClient(`CognitoAppClientForNone`, {
      oAuth: {
        flows: {
          implicitCodeGrant: true,
        },
        callbackUrls: ["https://jwt.io"],
        scopes: [OAuthScope.OPENID],
      },
      generateSecret: false,
      supportedIdentityProviders: [UserPoolClientIdentityProvider.COGNITO],
    });
    new cdk.CfnOutput(this, "AuthorizeUrlNone", {
      value: `${this.domain.baseUrl()}/authorize?client_id=${
        client.userPoolClientId
      }&response_type=token&scope=openid&redirect_uri=https://jwt.io`,
    });
  }

  private createVpc() {
    this.vpc = new Vpc(this, "Vpc", {
      enableDnsSupport: true,
      enableDnsHostnames: true,
      subnetConfiguration: [
        {
          name: "Public",
          subnetType: SubnetType.PUBLIC,
        },
        {
          name: "Isolated",
          subnetType: SubnetType.ISOLATED,
        },
      ],
    });
  }

  private createUserPool() {
    this.up = new UserPool(this, "UserPool", {
      autoVerify: { email: false, phone: false },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      selfSignUpEnabled: false,
    });
    this.domain = this.up.addDomain("UserPoolDomain", {
      cognitoDomain: {
        domainPrefix: "poc-two-ups-" + this.account,
      },
    });
  }

  private createSamlProviders() {
    const cluster = new Cluster(this, "EcsCluster", {
      vpc: this.vpc,
    });

    const vpcLink = new VpcLink(this, "VpcLink", {
      vpc: this.vpc,
      subnets: { subnetType: SubnetType.PUBLIC },
    });

    const sg = new SecurityGroup(this, "EcsTaskSecurityGroup", {
      vpc: this.vpc,
      allowAllOutbound: true,
    });
    sg.addIngressRule(Peer.anyIpv4(), Port.allTcp());

    const logGroup = new LogGroup(this, "CloudWatchHttpApiLogGroup");
    const namespace = new PrivateDnsNamespace(this, "CloudMapNamespace", {
      name: "P1PocCognitoSaml",
      vpc: this.vpc,
    });

    this.providers = {};
    for (const name of PROVIDER_NAMES) {
      const dnsService = new Service(this, `CloudMap${name}Service`, {
        namespace,
        dnsRecordType: DnsRecordType.SRV,
      });

      const api = new HttpApi(this, `Http${name}ProviderApi`, {
        defaultIntegration: new HttpServiceDiscoveryIntegration({
          service: dnsService,
          vpcLink,
        }),
      });
      const stage = api.defaultStage?.node.defaultChild as CfnStage;
      stage.accessLogSettings = {
        destinationArn: logGroup.logGroupArn,
        format: `$context.identity.sourceIp - - [$context.requestTime] "$context.httpMethod $context.routeKey $context.protocol" $context.status $context.responseLength $context.requestId $context.integrationErrorMessage`,
      };

      const taskDefinition = new FargateTaskDefinition(
        this,
        `Ecs${name}SamlProviderTask`,
        {
          cpu: 512,
          memoryLimitMiB: 1024,
        }
      );
      const container = taskDefinition.addContainer("Keycloak", {
        image: ContainerImage.fromAsset(resolve(__dirname, "keycloak"), {}),
        portMappings: [
          {
            containerPort: 8080,
            hostPort: 8080,
          },
        ],
        environment: {
          KEYCLOAK_FRONTEND_URL: api.url + "auth",
          COGNITO_URN: "urn:amazon:cognito:sp:" + this.up.userPoolId,
          COGNITO_URL: this.domain.baseUrl() + "/saml2/idpresponse",
        },
        logging: new AwsLogDriver({
          streamPrefix: "/ecs/p1-pocs/cognito-saml",
        }),
      });
      const service = new FargateService(this, `Ecs${name}ProviderService`, {
        cluster,
        taskDefinition,
        assignPublicIp: true,
        vpcSubnets: { subnetType: SubnetType.PUBLIC },
        securityGroups: [sg],
        desiredCount: 1,
      });
      service.associateCloudMapService({
        service: dnsService,
        container,
        containerPort: 8080,
      });

      this.providers[name] = {
        service,
        url: api.url as string,
      };
    }
  }
}
