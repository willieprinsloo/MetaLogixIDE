# State fixture

```mermaid
stateDiagram-v2
  [*] --> StateIdle
  StateIdle --> StateBusy
  StateBusy --> [*]
```
