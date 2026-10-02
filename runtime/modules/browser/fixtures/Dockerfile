# Image des fixtures (site de test et proxys). Base épinglée par empreinte (index multi-architecture node:24-alpine) ;
# Renovate la met à jour. Aucune dépendance npm : Node 24 exécute le TypeScript directement.
FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
WORKDIR /app
RUN echo '{"type":"module","private":true}' > package.json
COPY src ./src
# Utilisateur non root fourni par l'image (node, uid 1000).
USER node
ENTRYPOINT ["node", "src/main.ts"]
