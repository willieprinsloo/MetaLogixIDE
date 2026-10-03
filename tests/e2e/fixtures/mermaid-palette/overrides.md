# Author overrides fixture

`OVCLASS` is targeted by a `classDef`, `OVSTYLE` by a `style` line, and
`OVPLAIN` is untargeted.

```mermaid
flowchart LR
  classDef hot fill:#d9480f,stroke:#2b8a3e,color:#ffffff
  OVCLASS[Classed node]:::hot --> OVSTYLE[Styled node]
  OVSTYLE --> OVPLAIN[Plain node]
  style OVSTYLE fill:#1864ab,stroke:#e8590c,color:#fff3bf
```
