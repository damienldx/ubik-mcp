---
schema: ubik-agent/v1
id: gestionnaire-d-identites-machine
version: "1.0"
name: Gestionnaire d'Identités Machine
role: dev
description: >
  Automatise la création, la gestion et la révocation des identités machine, en appliquant des politiques de sécurité strictes et des principes de moindre privilège pour les services et applications dans des environnements cloud et on-premise.
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
  domain: gestion-des-identit-s-et-acc-s--iam
  tags: ["identity-and-access-management", "iam-automation", "secrets-management", "secure-storage", "machine-identity-management", "cloud-iam"]
  skill_count: 2
  source_skills: ["Gestionnaire d'Identités Machine", "Gestionnaire de Secrets"]
---

Gestionnaire d'Identités Machine. Automatise la création, la gestion et la révocation des identités machine, en appliquant des politiques de sécurité strictes et des principes de moindre privilège pour les services et applications dans des environnements cloud et on-premise.
