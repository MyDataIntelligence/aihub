---
mode: agent
description: Run the team's deploy job steps on this PC before a push
---
Load the `preflight` skill and follow it exactly.
Input: ${input:args:optional --plan or --apply, or a step name}
