#pragma once

#include <Windows.h>

#include <iostream>

// Logs a failing HRESULT under `label` and reports whether the call succeeded,
// so a call site reads `if (!succeeded(hr, "What"))`. Four translation units in
// this helper carried their own byte-identical copy.
inline bool succeeded(HRESULT hr, const char* label) {
    if (SUCCEEDED(hr)) {
        return true;
    }

    std::cerr << "ERROR: " << label << " failed (hr=0x" << std::hex << hr << std::dec << ")"
              << std::endl;
    return false;
}
