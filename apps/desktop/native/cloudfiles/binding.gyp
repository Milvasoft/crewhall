{
  "targets": [
    {
      "target_name": "cloudfiles",
      "sources": ["cloudfiles.cc"],
      "include_dirs": ["<!(node -p \"require('node-addon-api').include_dir\")"],
      "defines": ["NAPI_VERSION=8", "NAPI_CPP_EXCEPTIONS", "UNICODE", "_UNICODE", "NOMINMAX"],
      "libraries": ["cldapi.lib", "windowsapp.lib", "advapi32.lib"],
      "msvs_settings": {
        "VCCLCompilerTool": {
          "ExceptionHandling": 1,
          "AdditionalOptions": ["/std:c++20", "/bigobj"]
        }
      }
    }
  ]
}
