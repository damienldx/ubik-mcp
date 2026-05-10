---
schema: ubik-agent/v1
id: integration-api-gateway-couchdb
version: "1.0"
name: Intégration API Gateway CouchDB
role: dev
description: >
  Conçoit et documente des stratégies d'intégration sécurisées et performantes entre CouchDB et des API Gateways, en appliquant des patterns de sécurité, d'accès et de gestion de données.
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
  domain: patterns-design-couchdb
  tags: ["security-patterns", "couchdb-data-exposure", "rbac-couchdb", "access-control", "api-security-couchdb", "update-functions"]
  skill_count: 2
  source_skills: ["Intégration API Gateway CouchDB", "Modèle de Sécurité CouchDB"]
---

Intégration API Gateway CouchDB. Conçoit et documente des stratégies d'intégration sécurisées et performantes entre CouchDB et des API Gateways, en appliquant des patterns de sécurité, d'accès et de gestion de données.
