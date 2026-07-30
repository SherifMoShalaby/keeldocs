# Data model

## User
<!-- keeldocs: id=db.user recipe=erd@1 binds=fact:db-schema/User hash-kind=fact -->

<!-- keeldocs:gen id=db.user.columns hash=h1:9b93880a5563d4cc content=h1:71b1fcff71a3a1e3 -->
| column | type |
|---|---|
| id | Int |
| email | Text |
| role | Role |
<!-- /keeldocs:gen -->
