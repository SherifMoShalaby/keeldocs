;; NestJS endpoint query - decorator-shaped extraction (T0).
;; VALIDATED FINDING (E1, 2026-07-30): in the tree-sitter TS grammar, decorators on
;; EXPORTED classes attach to the export_statement node, not class_declaration -
;; the query must match both forms. @Controller also takes an object form
;; ({path, version}), used by 8/9 controllers in one fixture-corpus repo.
;; The working reference implementation is prototype/extract_nestjs.py (100% R / 100% P
;; on the E1 corpus, n=45). This .scm is the contribution-format target; keep it in
;; lockstep with the prototype until the engine's query runtime lands.
(class_declaration
  (decorator (call_expression
    function: (identifier) @_ctrl (#eq? @_ctrl "Controller")
    arguments: (arguments (string (string_fragment) @prefix)?)))
  body: (class_body
    (method_definition
      (decorator (call_expression
        function: (identifier) @verb (#any-of? @verb "Get" "Post" "Put" "Patch" "Delete")
        arguments: (arguments (string (string_fragment) @route)?)))
      name: (property_identifier) @handler) @method))
