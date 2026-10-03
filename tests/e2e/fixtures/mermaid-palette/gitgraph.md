# gitGraph palette fixture

```mermaid
gitGraph
  commit
  branch develop
  commit
  branch feature
  commit
  branch hotfix
  commit
  checkout main
  commit tag: "v1.0"
  checkout develop
  commit
  checkout feature
  commit
  checkout hotfix
  commit
```
