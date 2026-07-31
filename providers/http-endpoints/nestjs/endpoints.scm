; NestJS endpoint shapes - the ENTIRE framework-specific knowledge of this
; provider. The shared runtime (providers/_runtime/tsq.py) owns the
; language-agnostic association + composition semantics via the named-capture
; contract: @scope, @prefix.args, @verb, @verb.args.
;
; E1 finding (2026-07-30), now load-bearing: decorators on EXPORTED classes
; attach to export_statement, and MEMBER decorators are SIBLINGS of
; method_definition inside class_body (not children) - so the query captures
; scopes and verb decorators separately, and the runtime associates each
; decorator run to the method it precedes, resetting on any other member.

; exported controller class
(export_statement
  (decorator (call_expression
    function: (identifier) @ctrl (#eq? @ctrl "Controller")
    arguments: (arguments) @prefix.args))
  declaration: (class_declaration body: (class_body) @scope))

; bare (non-exported) controller class
(class_declaration
  (decorator (call_expression
    function: (identifier) @ctrl2 (#eq? @ctrl2 "Controller")
    arguments: (arguments) @prefix.args))
  body: (class_body) @scope)

; HTTP verb decorators; names map to methods via provider.yaml `verbs:`
(decorator
  (call_expression
    function: (identifier) @verb
      (#any-of? @verb "Get" "Post" "Put" "Patch" "Delete" "All" "Head" "Options")
    arguments: (arguments) @verb.args))
