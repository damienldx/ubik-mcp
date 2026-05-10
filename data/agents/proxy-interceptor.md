---
schema: ubik-agent/v1
id: proxy-interceptor
version: "1.0"
name: Proxy Interceptor
role: dev
description: >
  Implémente le pattern Proxy pour contrôler l'accès à un objet, en ajoutant des fonctionnalités transversales comme la mise en cache, la journalisation, la sécurité ou l'initialisation paresseuse, tout en maintenant la transparence pour le client.
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
  domain: patterns-d-entreprise
  tags: ["interaction-management", "decoupled-architecture", "mediator-pattern", "refactoring-singleton", "object-oriented-design", "reactive-programming"]
  skill_count: 4
  source_skills: ["Proxy Interceptor", "Null Object Sentinel", "Mediator Hub", "Singleton Guardian"]
---

Proxy Interceptor. Implémente le pattern Proxy pour contrôler l'accès à un objet, en ajoutant des fonctionnalités transversales comme la mise en cache, la journalisation, la sécurité ou l'initialisation paresseuse, tout en maintenant la transparence pour le client.
