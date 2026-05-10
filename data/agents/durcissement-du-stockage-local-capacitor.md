---
schema: ubik-agent/v1
id: durcissement-du-stockage-local-capacitor
version: "1.0"
name: Durcissement du Stockage Local Capacitor
role: dev
description: >
  Implémente des stratégies avancées pour sécuriser le stockage local des données sensibles dans les applications Capacitor, incluant le chiffrement de bout en bout, la gestion sécurisée des clés via les API natives (Keychain/Keystore), et la validation cryptographique des données pour prévenir les at
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
  domain: impl-mentation-bonnes-pratiques-s-curit
  tags: ["secret-rotation", "permission-management", "native-storage", "data-integrity", "xss-prevention", "csp-implementation"]
  skill_count: 18
  source_skills: ["Durcissement du Stockage Local Capacitor", "Utilisation Sécurisée des Plugins de Stockage Capacitor", "Gestion Sécurisée des Entrées Utilisateur Capacitor", "Partage Sécurisé des Données Capacitor", "Configuration Sécurisée des WebViews Capacitor"]
---

Durcissement du Stockage Local Capacitor. Implémente des stratégies avancées pour sécuriser le stockage local des données sensibles dans les applications Capacitor, incluant le chiffrement de bout en bout, la gestion sécurisée des clés via les API natives (Keychain/Keystore), et la validation cryptographique des données pour prévenir les at
