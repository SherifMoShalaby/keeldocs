# ERD template

The shape `renderDataModelDoc` emits. Fenced deliberately: this file now lives
under `docs/`, which `check` scans, and an unfenced anchor here parses as a real
one — moving the directory scored two sections of a specification's illustration
as documented surfaces of keeldocs itself, inflating the coverage number of the
tool whose entire argument is that a coverage number has to mean something.

```markdown
# Data model
<!-- keeldocs: id=db.root recipe=erd@1 binds=fact:db-schema/* hash-kind=fact -->

<!-- keeldocs:slot id=db.overview binds=fact:db-schema/* max-words=120 --><!-- /keeldocs:slot -->

## Diagram
<!-- keeldocs:gen id=db.root.diagram --><!-- /keeldocs:gen -->

<!-- per-table sections generated below; humans own everything outside markers -->
```
