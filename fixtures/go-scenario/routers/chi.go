package routers

import "github.com/go-chi/chi/v5"

func ChiRoutes() {
	r := chi.NewRouter()
	r.Get("/ping", ping)
	r.Route("/api/v3", func(r chi.Router) {
		r.Get("/reports", listReports)
		r.Post("/reports", createReport)
	})
}
