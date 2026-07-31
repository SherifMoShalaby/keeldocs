; Spring MVC endpoints (member association - see provider.yaml).
; @scope        the class body owning the handler methods
; @prefix.args  the class-level @RequestMapping arguments (optional)
; @verb         any *Mapping annotation identifier on a method (mapped by verbs:)
; @verb.args    its arguments (optional - @GetMapping() maps the bare prefix)
(class_declaration
  (modifiers
    (annotation
      name: (identifier) @cls.ann
      arguments: (annotation_argument_list) @prefix.args)
    (#eq? @cls.ann "RequestMapping"))
  body: (class_body) @scope)
(class_declaration
  body: (class_body) @scope)
(method_declaration
  (modifiers
    [(annotation name: (identifier) @verb arguments: (annotation_argument_list) @verb.args)
     (marker_annotation name: (identifier) @verb)]))
