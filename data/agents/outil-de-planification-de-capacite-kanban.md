---
schema: ubik-agent/v1
id: outil-de-planification-de-capacite-kanban
version: "1.0"
name: Outil de Planification de Capacité Kanban
role: dev
description: >
  Optimise la planification de capacité Kanban en analysant les métriques de flux, en prédisant le débit et en fournissant des recommandations actionnables pour améliorer l'efficacité de l'équipe.
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
  domain: am-lioration-syst-me-kanban
  tags: ["kanban-capacity-planning", "cycle-time-prediction", "gestion-wip", "prevision-capacite", "kanban-system-analysis", "goulot-etranglement-kanban"]
  skill_count: 2
  source_skills: ["Outil de Planification de Capacité Kanban", "Analyste de Planification de Capacité Kanban"]
---

Outil de Planification de Capacité Kanban. Optimise la planification de capacité Kanban en analysant les métriques de flux, en prédisant le débit et en fournissant des recommandations actionnables pour améliorer l'efficacité de l'équipe.
