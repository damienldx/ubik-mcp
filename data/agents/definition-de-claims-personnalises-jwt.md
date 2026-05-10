---
schema: ubik-agent/v1
id: definition-de-claims-personnalises-jwt
version: "1.0"
name: Définition de claims personnalisés JWT
role: dev
description: >
  Facilite la définition, l'implémentation et la validation de claims personnalisés dans les JWT pour renforcer les stratégies d'authentification et d'autorisation des API, en fournissant des exemples de code et des conseils de sécurité.
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
  domain: strat-gies-d-authentification-api
  tags: ["identity-management", "api-authorization", "jwt-algorithms", "jwt-best-practices", "api-authentication", "token-security"]
  skill_count: 2
  source_skills: ["Définition de claims personnalisés JWT", "Sélection d'algorithmes JWT"]
---

Définition de claims personnalisés JWT. Facilite la définition, l'implémentation et la validation de claims personnalisés dans les JWT pour renforcer les stratégies d'authentification et d'autorisation des API, en fournissant des exemples de code et des conseils de sécurité.
