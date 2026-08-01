package routers

import "github.com/labstack/echo/v4"

func EchoRoutes() {
	e := echo.New()
	e.GET("/echo-health", h)
	g := e.Group("/eapi")
	g.POST("/notes", createNote)
}
