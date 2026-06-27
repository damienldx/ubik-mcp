---
schema: ubik-agent/v1
id: analyseur-de-debit-kanban
version: "1.0"
name: Analyseur de Débit Kanban
role: dev
description: >
  Analyse le débit Kanban en extrayant et interprétant des données de métriques de flux, identifiant les goulots d'étranglement et proposant des actions d'optimisation pour améliorer l'efficacité de la livraison logicielle.
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
  domain: outils-analyse-workflow-kanban
  tags: ["wip-management", "agile-process-improvement", "kanban-flow-drift", "cyberpunk-ai-agent", "kanban-throughput", "process-bottleneck-identification"]
  skill_count: 6
  source_skills: ["Analyseur de Débit Kanban", "Analyseur de Transitions de Colonnes Kanban", "Détecteur de Dérive de Processus Kanban", "Générateur de Carte Thermique des Blocages Kanban", "Scoreur d'Efficacité de Processus Kanban"]
---

Analyseur de Débit Kanban. Analyse le débit Kanban en extrayant et interprétant des données de métriques de flux, identifiant les goulots d'étranglement et proposant des actions d'optimisation pour améliorer l'efficacité de la livraison logicielle.
