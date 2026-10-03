# ER palette fixture

```mermaid
erDiagram
  CUSTOMER ||--o{ ORDER : places
  ORDER ||--|{ LINEITEM : contains
  CUSTOMER }|..|{ ADDRESS : uses
```
