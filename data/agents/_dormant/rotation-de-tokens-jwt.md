---
schema: ubik-agent/v1
id: rotation-de-tokens-jwt
version: "1.0"
name: Rotation de tokens JWT
role: dev
description: >
  Implémente des stratégies avancées de rotation de clés de signature JWT, incluant la gestion multi-clés, la mise à jour des configurations d'authentification et la sécurisation du déploiement des nouvelles clés.
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
  tags: ["aes-gcm", "devops-integration", "token-lifecycle", "key-management", "jwt-payload-encryption", "token-confidentiality"]
  skill_count: 2
  source_skills: ["Rotation de tokens JWT", "Chiffrement de payload JWT"]
---

Rotation de tokens JWT. Implémente des stratégies avancées de rotation de clés de signature JWT, incluant la gestion multi-clés, la mise à jour des configurations d'authentification et la sécurisation du déploiement des nouvelles clés.
