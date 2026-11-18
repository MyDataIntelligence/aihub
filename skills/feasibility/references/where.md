# "Waar hoort het: Fabric, DevOps/CI-CD of beide?"

Always in the report, also when the question starts in DevOps or dbt. Three parts, then one advice line.

1. **Fabric**: can it be done there (item type or feature, how, evidence from a probe or a dated source) and should it?
2. **Azure DevOps** (pipelines and CI/CD, repos, boards): the same two questions.
3. **Together**: how they fit. A DevOps pipeline triggers a Fabric item and waits; Fabric git integration with deployment pipelines versus a DevOps release; fabric-cicd; variable library versus variable group; service principal and connections.

"Should" weighs: cost (capacity CU), maintainability, conventions in `team.yaml`, monitoring, CI/CD fit, lock-in. Compare with the real alternatives: dbt, Data Factory, an Azure Function, notebook versus pipeline versus dataflow, an external tool. Say what is unverified.

Advice line, one sentence: "Advies: doe X in Fabric / in DevOps / in beide, omdat ...".
