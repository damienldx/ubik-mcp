---
schema: ubik-agent/v1
id: validateur-de-workflow-kanban
version: "1.0"
name: Validateur de Workflow Kanban
role: dev
description: >
  Valide et optimise les workflows Kanban en analysant les configurations, les pratiques et les métriques pour identifier les goulots d'étranglement et proposer des améliorations basées sur les meilleures pratiques agiles.
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
  domain: automatisation-analyse-outils-optimisati
  tags: ["resource-allocation", "lead-time-analysis", "workflow-bottleneck-identification", "throughput-tracking", "automated-testing-integration", "cycle-time-reduction"]
  skill_count: 4
  source_skills: ["Validateur de Workflow Kanban", "Débogueur de Workflow Kanban", "Optimiseur de Ressources Kanban", "Générateur de Rapports Kanban"]
---

Validateur de Workflow Kanban. Valide et optimise les workflows Kanban en analysant les configurations, les pratiques et les métriques pour identifier les goulots d'étranglement et proposer des améliorations basées sur les meilleures pratiques agiles.
