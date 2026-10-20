# Learning-oriented design and its limits

This extension helps prepare review material. It does not promise maximum learning efficiency or measured translation accuracy. Anki remains responsible for review scheduling; this extension does not change FSRS, intervals, due dates, or review history.

## Decisions

- One selected contextual sense per note; recognition or cloze creates one card. No automatic reverse card or bulk expansion.
- Recognition shows the expression and original sentence. Cloze hides the exact selected occurrence. The answer, pronunciation audio and generated examples stay on the back, so the front does not reveal the answer.
- Additional examples are generated only on an explicit action, labelled as AI-generated, and individually selected. Up to three examples can be kept as optional supporting detail; none are included automatically. The original quotation is never replaced by a simpler invented sentence.
- Source/target language and CEFR target are captured with the lookup and immutable draft. Same-language study is allowed for definitions/paraphrases. CEFR is an approximate generation target, not a certified assessment.
- Source and translation retain their exact logical strings with separate language/direction markup. Chinese locale refers to Mandarin; Arabic locale to Modern Standard Arabic, not every regional variety.
- Synthetic audio and approximate generated IPA are labelled. A missing matching local voice does not silently switch to English or a paid service.
- The reader popup may immediately explain a word during reading. Retrieval effort belongs in deliberate review, not a mandatory obstacle to understanding a passage.

## Evidence informing these decisions

- Repeated retrieval can improve delayed foreign-vocabulary recall: [Karpicke & Roediger, 2008](https://doi.org/10.1126/science.1152408). This does not prove that cloze always outperforms recognition.
- Spaced practice supports long-term vocabulary retention: [Bahrick et al., 1993](https://infantlab.fiu.edu/publications/publications-by-date/publications-1990-1999/1993_bahrick-et-al_ps_maintenance-of-foreign-language-vocabulary-and.pdf). The cited experiment was small (four participants). The one-sense-per-card choice is a conservative design inference, not a universal measured optimum.
- Context and feedback matter, especially when initial knowledge is weak: [Van den Broek et al., 2022](https://pmc.ncbi.nlm.nih.gov/articles/PMC9285746/). More difficult retrieval is not automatically better.
- Vocabulary coverage relates to comprehension without a universal magic cutoff: [Schmitt, Jiang & Grabe, 2011](https://www.lextutor.ca/cover/papers/schmitt_etal_2011.pdf). This motivates understandable supporting examples, not a claimed percentage threshold for short cards.
- Producing vocabulary before auditory feedback can help learning: [Kang, Gollan & Pashler, 2013](https://pubmed.ncbi.nlm.nih.gov/23681928/). Their immediate/two-day tests do not establish long-term pronunciation mastery or validate synthetic audio.
- [Anki deck options](https://docs.ankiweb.net/manual/deck-options) and [template fields](https://docs.ankiweb.net/manual/templates/fields) describe review load, cloze and hints. Scheduling is deliberately left to Anki and the learner.

## Verification still needed

Automated tests check data integrity, target ranges, example selection, version compatibility, answer placement and safe rendering. They cannot certify linguistic naturalness, CEFR level, speech quality, useful cloze difficulty or learning effectiveness. Evaluate those with human review, real supported browsers, and delayed recall plus transfer to a new context. Paid provider runs require a safely configured key and an authorized budget; none are implied by this document.
