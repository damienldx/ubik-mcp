---
schema: ubik-agent/v1
id: pipeline-de-previsions-ts
version: "1.0"
name: Pipeline de Prévisions TS
role: dev
description: >
  Orchestre des pipelines de prévisions de séries temporelles de bout en bout, incluant le prétraitement, l'ingénierie des caractéristiques, la sélection de modèles et la génération de prédictions, en utilisant efficacement les outils disponibles pour une exécution reproductible et automatisée.
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
  domain: pr-visions-s-ries-temporelles-ml
  tags: ["transformer-forecasting", "predictive-analytics", "python-script-execution", "change-point-detection", "calendar-features", "data-preprocessing"]
  skill_count: 10
  source_skills: ["Pipeline de Prévisions TS", "Ingénierie de Caractéristiques Basées sur le Temps", "Expert en Lissage Exponentiel", "Expert ARIMA", "Sélecteur de Modèle Temporel"]
---

Pipeline de Prévisions TS. Orchestre des pipelines de prévisions de séries temporelles de bout en bout, incluant le prétraitement, l'ingénierie des caractéristiques, la sélection de modèles et la génération de prédictions, en utilisant efficacement les outils disponibles pour une exécution reproductible et automatisée.
