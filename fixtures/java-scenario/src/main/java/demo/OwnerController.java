package demo;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/owners")
class OwnerController {

    @GetMapping
    public String list() { return "all"; }

    @GetMapping("/{id}")
    public String one(@PathVariable int id) { return "one"; }

    @PostMapping("/new")
    public String create() { return "created"; }

    @GetMapping({ "/find", "/search" })
    public String find() { return "find"; }
}
