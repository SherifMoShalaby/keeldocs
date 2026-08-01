var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

app.MapGet("/health", () => "ok");

var api = app.MapGroup("/api/v2");
api.MapGet("/tags", ListTags);
api.MapPost("/tags", CreateTag);

var admin = api.MapGroup(AdminPrefix());  // non-literal: gap, never a guess
admin.MapGet("/stats", Stats);

app.Run();
