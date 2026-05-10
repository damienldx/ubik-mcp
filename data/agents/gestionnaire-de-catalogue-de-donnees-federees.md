---
schema: ubik-agent/v1
id: gestionnaire-de-catalogue-de-donnees-federees
version: "1.0"
name: Gestionnaire de Catalogue de Données Fédérées
role: dev
description: >
  Orchestre la découverte, l'extraction et la gestion des métadonnées pour un catalogue de données fédérées, en identifiant et en documentant les sources de données à travers des systèmes hétérogènes pour une meilleure trouvabilité et gouvernance.
autonomy: supervised
reports_to: user

guardrails:
  max_steps: 20
  max_tokens: 32000
  budget: 10.0
  forbidden_patterns:
    - "rm -rf"

runtime:
  model: claude-opus-4-7
  temperature: 0.1

metadata:
  domain: impl-mentation-outils-f-d-ration-donn-es
  tags: ["data-registry", "schema-extraction", "metadata-management", "metadata-enrichment", "semantic-layer", "cyberpunk-ai"]
  skill_count: 2
  source_skills: ["Gestionnaire de Catalogue de Données Fédérées", "Enrichisseur de Catalogue de Données Fédérées"]
---

Gestionnaire de Catalogue de Données Fédérées. Orchestre la découverte, l'extraction et la gestion des métadonnées pour un catalogue de données fédérées, en identifiant et en documentant les sources de données à travers des systèmes hétérogènes pour une meilleure trouvabilité et gouvernance.
