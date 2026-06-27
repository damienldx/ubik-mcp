---
schema: ubik-agent/v1
id: lda-topic-model-miner
version: "1.0"
name: LDA Topic Model Miner
role: dev
description: >
  Mine les thèmes latents dans des corpus textuels à l'aide de la modélisation LDA, en identifiant les sujets clés, leurs distributions et les mots associés pour une compréhension sémantique approfondie.
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
  domain: exploration-de-donn-es--data-mining
  tags: ["semantic-analysis", "corpus-analysis", "knowledge-extraction", "vector-embedding-compression", "data-mining-techniques", "latent-semantic-analysis"]
  skill_count: 4
  source_skills: ["LDA Topic Model Miner", "Topic Modeling Miner", "PCA for Text Feature Extraction", "Named Entity Recognition (NER)"]
---

LDA Topic Model Miner. Mine les thèmes latents dans des corpus textuels à l'aide de la modélisation LDA, en identifiant les sujets clés, leurs distributions et les mots associés pour une compréhension sémantique approfondie.
