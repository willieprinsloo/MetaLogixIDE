# Flowchart palette fixture

The first diagram is plain and takes the app palette. The two after it pin
Mermaid's built-in `dark` and `default` themes: they are the oracles AC1 and
AC2 compare the plain render against.

```mermaid
flowchart LR
  PALSTART[Palette start] -->|PALEDGE| PALCHOICE{Palette choice}
  PALCHOICE --> PALEND[Palette end]
```

```mermaid
%%{init: {"theme":"dark"}}%%
flowchart LR
  DARKSTART[Palette start] -->|PALEDGE| DARKCHOICE{Palette choice}
  DARKCHOICE --> DARKEND[Palette end]
```

```mermaid
%%{init: {"theme":"default"}}%%
flowchart LR
  DEFSTART[Palette start] -->|PALEDGE| DEFCHOICE{Palette choice}
  DEFCHOICE --> DEFEND[Palette end]
```
