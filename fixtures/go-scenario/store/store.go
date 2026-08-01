package store

import (
	"example.com/go-scenario-fixture/models"
	"os"
)

var dsn = os.Getenv("STORE_DSN")

type Store interface {
	Get(id int) string
}

func Open() Store { return nil }

func internalHelper() {}
