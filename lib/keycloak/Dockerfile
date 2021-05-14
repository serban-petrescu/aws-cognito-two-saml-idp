FROM jboss/keycloak:13.0.0

USER root

COPY test.json /opt/test.json
RUN chmod 777 /opt/test.json

ENV KEYCLOAK_USER admin
ENV KEYCLOAK_PASSWORD admin

ENV DB_VENDOR h2

ENV KEYCLOAK_IMPORT /opt/test.json

ENTRYPOINT []

CMD sed -i 's@COGNITO_URN@'"$COGNITO_URN"'@' /opt/test.json && \
    sed -i 's@COGNITO_URL@'"$COGNITO_URL"'@' /opt/test.json && \
    /opt/jboss/tools/docker-entrypoint.sh -b 0.0.0.0
