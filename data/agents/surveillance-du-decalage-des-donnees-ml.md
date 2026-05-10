---
schema: ubik-agent/v1
id: surveillance-du-decalage-des-donnees-ml
version: "1.0"
name: Surveillance du Décalage des Données ML
role: dev
description: >
  Implémente des pipelines de surveillance continue des distributions de données d'entrée pour détecter le décalage des données ML, en utilisant des métriques statistiques et des seuils configurables pour déclencher des alertes.
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
  domain: outils-d-tection-d-calage-mod-le-ml
  tags: ["data-integrity", "cybersecurity-ai", "alerting-system", "data-validation-metrics", "feature-distribution-analysis", "concept-drift-analysis"]
  skill_count: 19
  source_skills: ["Surveillance du Décalage des Données ML", "Détection de Décalage des Données ML", "Détecteur de Décalage Performance Modèle ML", "Seuils de Décalage des Données ML", "Seuils de Performance Modèle ML"]
---

Surveillance du Décalage des Données ML. Implémente des pipelines de surveillance continue des distributions de données d'entrée pour détecter le décalage des données ML, en utilisant des métriques statistiques et des seuils configurables pour déclencher des alertes.
