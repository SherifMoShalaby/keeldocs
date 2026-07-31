package main

import "github.com/gin-gonic/gin"

func main() {
	r := gin.Default()
	r.GET("/health", health)

	api := r.Group("/api")
	v1 := api.Group("/v1")
	v1.GET("/tags", listTags)
	v1.POST("/tags", createTag)
	v1.DELETE("/tags/:id", deleteTag)

	admin := r.Group(adminPrefix()) // non-literal: must be a gap, never a guess
	admin.GET("/stats", stats)

	r.Run()
}
