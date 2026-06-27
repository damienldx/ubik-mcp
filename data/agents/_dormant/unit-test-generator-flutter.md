---
schema: ubik-agent/v1
id: unit-test-generator-flutter
version: "1.0"
name: Unit Test Generator Flutter
role: dev
description: >
  Génère des tests unitaires Dart/Flutter complets et robustes en utilisant des patterns éprouvés comme AAA, le mocking et la couverture des cas limites pour assurer l'intégrité et la maintenabilité du code.
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
  domain: d-veloppement-cross-platform--flutter
  tags: ["flutter-reliability", "test-automation", "integration-testing", "ci-cd-testing", "widget-testing", "test-driven-development"]
  skill_count: 2
  source_skills: ["Unit Test Generator Flutter", "Testing Strategist Flutter"]
---

Unit Test Generator Flutter. Génère des tests unitaires Dart/Flutter complets et robustes en utilisant des patterns éprouvés comme AAA, le mocking et la couverture des cas limites pour assurer l'intégrité et la maintenabilité du code.
