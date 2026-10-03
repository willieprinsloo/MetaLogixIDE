# State palette fixture

```mermaid
stateDiagram-v2
  [*] --> PalIdle
  PalIdle --> PalBusy : start
  PalBusy --> PalIdle : finish
  PalBusy --> [*]
```
