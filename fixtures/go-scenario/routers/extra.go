package routers

// a route on a receiver this file never defines: cross-file honesty gap
func Register(g Grouper) {
	g.POST("/exports", doExport)
}
