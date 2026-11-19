package main

import (
	"errors"
	"os"
	"path/filepath"
	"syscall"
	"unsafe"
)

var getDriveType = kernel32.NewProc("GetDriveTypeW")

func nativeWorkspace(abs string) (string, error) {
	if err := localDrive(abs); err != nil {
		return "", err
	}
	resolved, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return "", err
	}
	return resolved, localDrive(resolved)
}

func localDrive(path string) error {
	volume := filepath.VolumeName(path)
	if len(volume) != 2 || volume[1] != ':' {
		return errors.New("必须指定本地盘符下的目录")
	}
	root, err := syscall.UTF16PtrFromString(volume + `\`)
	if err != nil {
		return err
	}
	driveType, _, _ := getDriveType.Call(uintptr(unsafe.Pointer(root)))
	// DRIVE_REMOVABLE, DRIVE_FIXED, DRIVE_RAMDISK
	if driveType != 2 && driveType != 3 && driveType != 6 {
		return errors.New("网络驱动器或不可写的媒体不支持作为工作目录")
	}
	return nil
}

func verifyFile(f *os.File) error {
	var info syscall.ByHandleFileInformation
	if err := syscall.GetFileInformationByHandle(syscall.Handle(f.Fd()), &info); err != nil {
		return err
	}
	const hiddenSystemReparse = 0x0002 | 0x0004 | 0x0400
	if info.NumberOfLinks != 1 || info.FileAttributes&hiddenSystemReparse != 0 {
		return errors.New("不允许访问隐藏文件、系统文件或链接文件")
	}
	return nil
}
