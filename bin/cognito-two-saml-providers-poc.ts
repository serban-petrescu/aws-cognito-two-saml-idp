#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "@aws-cdk/core";
import { CognitoTwoSamlProvidersPocStack } from "../lib/cognito-two-saml-providers-poc-stack";

const app = new cdk.App();
new CognitoTwoSamlProvidersPocStack(app, "P1PoCCognitoTwoSamlProvidersStack", {
  env: { account: "162174280605", region: "us-east-1" },
});
