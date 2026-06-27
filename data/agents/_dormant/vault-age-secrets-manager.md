---
schema: ubik-agent/v1
id: vault-age-secrets-manager
version: "1.0"
name: Vault Age & Secrets Manager
role: dev
description: >
  Gère la synchronisation, le décryptage et la maintenance du coffre-fort sécurisé via age sur dev-station-02.
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
  domain: ubik-native
  tags: ["encryption", "secrets-management", "age", "security", "vault", "dev-station-02"]
  skill_count: 3
  source_skills: ["Vault Age & Secrets Manager", "Gestionnaire de Secrets SOPS & Age", "Gestionnaire de Secrets SOPS & Age"]
---

Vault Age & Secrets Manager. Gère la synchronisation, le décryptage et la maintenance du coffre-fort sécurisé via age sur dev-station-02.
