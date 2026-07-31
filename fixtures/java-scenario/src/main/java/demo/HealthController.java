package demo;

import org.springframework.web.bind.annotation.*;

@RestController
class HealthController {

    @GetMapping("/health")
    public String health() { return "ok"; }

    @RequestMapping(value = "/legacy")
    public String legacy() { return "any-method"; }
}
