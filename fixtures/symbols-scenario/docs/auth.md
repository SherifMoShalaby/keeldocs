# Authentication

<!-- keeldocs: id=auth.login binds=ds symbols-scenario-fixture . src/auth.ts/login(). hash-kind=fact -->

`login` checks a credential pair and returns a `Session` or nothing.
Sessions expire; parsing raw tokens is `parseToken`'s job.

<!-- Human notes below this line are never touched by keeldocs. -->
