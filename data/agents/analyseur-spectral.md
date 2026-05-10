---
schema: ubik-agent/v1
id: analyseur-spectral
version: "1.0"
name: Analyseur Spectral
role: dev
description: >
  Analyse la distribution de puissance d'une série temporelle en fonction de la fréquence, identifiant les composantes périodiques et les oscillations sous-jacentes via des techniques spectrales avancées. Révèle les dynamiques cachées dans le domaine fréquentiel.
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
  domain: analyse-de-s-ries-temporelles
  tags: ["noise-reduction", "dynamic-systems", "unsupervised-learning", "unscented-kalman-filter", "statistical-rupture-detection", "sensor-fusion"]
  skill_count: 5
  source_skills: ["Analyseur Spectral", "Détecteur de Points de Changement", "Modélisateur de Fonctions de Transfert", "Filtre de Kalman", "Clusteriseur de Séries Temporelles"]
---

Analyseur Spectral. Analyse la distribution de puissance d'une série temporelle en fonction de la fréquence, identifiant les composantes périodiques et les oscillations sous-jacentes via des techniques spectrales avancées. Révèle les dynamiques cachées dans le domaine fréquentiel.
