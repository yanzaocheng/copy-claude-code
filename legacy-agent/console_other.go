//go:build !windows

package main

import "os"

func isConsole(*os.File) bool         { return false }
func clearConsoleInput(*os.File) bool { return false }
func ownConsole() bool                { return false }
