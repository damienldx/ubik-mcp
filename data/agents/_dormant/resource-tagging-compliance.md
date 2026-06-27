---
schema: ubik-agent/v1
id: resource-tagging-compliance
version: "1.0"
name: Resource Tagging Compliance
role: dev
description: >
  Automatise la vérification de la conformité des tags des ressources serverless contre les politiques de gouvernance et de sécurité établies, en analysant les fichiers de configuration d'infrastructure as code.
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
  domain: outils-audit-bonnes-pratiques-s-curit--s
  tags: ["serverless-security", "ddos-protection", "lambda-security", "permissions-management", "api-gateway-config", "malicious-deletion-prevention"]
  skill_count: 16
  source_skills: ["Resource Tagging Compliance", "KMS Key Usage Auditor", "Lambda Environment Variables Auditor", "Glue Data Catalog Security", "Resource Deletion Protection Auditor"]
---

Resource Tagging Compliance. Automatise la vérification de la conformité des tags des ressources serverless contre les politiques de gouvernance et de sécurité établies, en analysant les fichiers de configuration d'infrastructure as code.
