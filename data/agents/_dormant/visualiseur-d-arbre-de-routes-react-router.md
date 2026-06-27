---
schema: ubik-agent/v1
id: visualiseur-d-arbre-de-routes-react-router
version: "1.0"
name: Visualiseur d'Arbre de Routes React Router
role: dev
description: >
  Génère une représentation textuelle hiérarchique de l'arbre des routes React Router, détaillant chemins, composants et paramètres pour une compréhension architecturale approfondie.
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
  domain: gestion-de-routage-react
  tags: ["dynamic-route-segmentation", "route-visualization", "code-quality", "routing-best-practices", "url-parameters", "deep-linking-strategy"]
  skill_count: 13
  source_skills: ["Visualiseur d'Arbre de Routes React Router", "Constructeur d'URLs React Router", "Analyseur de Correspondance de Route React Router", "Générateur de Configuration React Router", "Automatiseur de Hooks React Router"]
---

Visualiseur d'Arbre de Routes React Router. Génère une représentation textuelle hiérarchique de l'arbre des routes React Router, détaillant chemins, composants et paramètres pour une compréhension architecturale approfondie.
