---
layout: home
title: "Scrapyomama Runtime"
hero:
  name: Scrapyomama Runtime
  text: "Un Apify agentique, open source"
  tagline: "On demande une donnée à son IA, en MCP. Un agent trouve la méthode la moins chère, l'enregistre comme une API du catalogue et la rejoue à coût de code. Auto-hébergé : votre base, votre modèle, vos proxys."
  actions:
    - theme: brand
      text: "Démarrage rapide"
      link: /tutoriels/quickstart
    - theme: alt
      text: "Usage responsable"
      link: /explications/usage-responsable
features:
  - title: Tutoriels
    details: "Apprendre en faisant, de l'installation à la première API."
    link: /tutoriels/quickstart
  - title: Guides pratiques
    details: "Déployer, brancher son modèle, sauvegarder, mettre à jour."
    link: /guides/deploiement
  - title: Référence
    details: "REST, MCP, variables d'environnement, statuts, versions."
    link: /reference/variables-environnement
  - title: Explications
    details: "Comprendre l'architecture, la sécurité et les limites assumées."
    link: /explications/architecture
---

## Ce que fait le produit, et ce qu'il ne fait pas

**Il fait** : enquêter sur un site pour trouver la méthode la moins chère (une requête HTTP, un navigateur, un agent), valider la sortie contre un schéma, la rejouer à coût de code, la réparer quand elle casse, et vous dire l'état de chaque API (saine, à surveiller, bloquée…). Il s'appelle en MCP comme en REST, se partage avec une équipe sans que chacun voie les données des autres, et s'installe sur Render, sur un VPS ou sur n'importe quel hébergeur de conteneurs.

**Il ne fait pas** : résoudre de captcha, masquer son identité, franchir un défi anti-robot, changer d'adresse IP après un refus, faire tourner plusieurs comptes. Il respecte `robots.txt` sans option pour l'ignorer. Ce n'est pas une limite technique, c'est une ligne choisie : voir [Hors périmètre](/explications/hors-perimetre). Certains sites protégés resteront donc « bloqués », même pour un usage légitime.

Il n'envoie **rien** à l'éditeur ([Télémétrie](/explications/telemetrie)), et la conformité de vos collectes reste **votre responsabilité** ([Usage responsable](/explications/usage-responsable)).

## Par où commencer

- Vous découvrez : le [démarrage rapide](/tutoriels/quickstart).
- Vous installez pour de bon : [Déployer une instance](/guides/deploiement).
- Vous êtes webmaster : [Le robot Scrapyomama](/explications/robot).
- Vous êtes un LLM ou un outil : [llms.txt](/llms.txt) et [llms-full.txt](/llms-full.txt), ainsi que la version Markdown de chaque page.
