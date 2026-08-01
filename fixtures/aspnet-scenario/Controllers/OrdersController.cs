[ApiController]
[Route("api/[controller]")]
public class OrdersController : ControllerBase
{
    [HttpGet]
    public IActionResult List() => Ok();

    [HttpGet("{id}")]
    public IActionResult One(int id) => Ok();

    [HttpPost]
    public IActionResult Create() => Ok();

    [HttpDelete("{id}")]
    public IActionResult Remove(int id) => Ok();
}
