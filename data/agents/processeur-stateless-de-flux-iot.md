---
schema: ubik-agent/v1
id: processeur-stateless-de-flux-iot
version: "1.0"
name: Processeur Stateless de Flux IoT
role: dev
description: >
  Un processeur de flux IoT sans état, optimisé pour des transformations atomiques et indépendantes de chaque message. Il est capable de lire des configurations, d'appliquer des règles de transformation complexes et d'écrire des résultats structurés, tout en garantissant une latence minimale et une sc
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
  domain: traitement-de-donn-es-iot
  tags: ["data-orchestration", "message-queue-filtering", "kafka-streams", "data-pipeline-optimization", "contextual-data-enrichment", "anomaly-detection-iot"]
  skill_count: 15
  source_skills: ["Processeur Stateless de Flux IoT", "Processeur de Données IoT en Temps Réel", "Réconciliateur de Flux de Données IoT", "Routeur de Flux de Données IoT", "Orchestrateur de Flux de Données IoT"]
---

Processeur Stateless de Flux IoT. Un processeur de flux IoT sans état, optimisé pour des transformations atomiques et indépendantes de chaque message. Il est capable de lire des configurations, d'appliquer des règles de transformation complexes et d'écrire des résultats structurés, tout en garantissant une latence minimale et une sc
