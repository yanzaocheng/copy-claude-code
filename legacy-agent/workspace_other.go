//go:build !windows

package main

import (
	"os"
	"path/filepath"
)

func nativeWorkspace(abs string) (string, error) { return filepath.EvalSymlinks(abs) }
func verifyFile(*os.File) error                  { return nil }
