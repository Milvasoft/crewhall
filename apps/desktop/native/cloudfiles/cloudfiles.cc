// Windows Cloud Files API for the virtual drive (src/cloud). Plain wrappers: what to do with them
// lives in TypeScript, so it can be tested without Windows.
//
// Every call that touches the disk runs on the thread pool and returns a promise: a placeholder
// operation can wait for the file system, and the main process must not wait with it.
#include <napi.h>

#include <windows.h>
#include <winternl.h>
#include <cfapi.h>
#include <sddl.h>

#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Foundation.Collections.h>
#include <winrt/Windows.Security.Cryptography.h>
#include <winrt/Windows.Storage.Provider.h>
#include <winrt/Windows.Storage.Streams.h>
#include <winrt/Windows.Storage.h>

#include <functional>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

#ifndef STATUS_SUCCESS
#define STATUS_SUCCESS ((NTSTATUS)0x00000000L)
#endif
#define CF_OP_PARAM_SIZE(field) \
  (FIELD_OFFSET(CF_OPERATION_PARAMETERS, field) + RTL_FIELD_SIZE(CF_OPERATION_PARAMETERS, field))

namespace {

using namespace winrt::Windows::Storage;
using namespace winrt::Windows::Storage::Provider;

std::wstring Wide(const std::string& s) {
  if (s.empty()) return {};
  int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), nullptr, 0);
  std::wstring w(n, 0);
  MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), w.data(), n);
  return w;
}

std::string Narrow(const wchar_t* w) {
  if (!w || !*w) return {};
  int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, nullptr, 0, nullptr, nullptr);
  std::string s(n > 0 ? n - 1 : 0, 0);
  if (n > 0) WideCharToMultiByte(CP_UTF8, 0, w, -1, s.data(), n, nullptr, nullptr);
  return s;
}

/** A failed call; the promise rejects with `hresult` set, as in "0x80070020". */
struct Failure {
  HRESULT hr;
  std::string what;
};

void Check(HRESULT hr, const char* what) {
  if (FAILED(hr)) throw Failure{hr, what};
}

std::string Hex(HRESULT hr) {
  char buf[16];
  snprintf(buf, sizeof(buf), "0x%08x", (unsigned)hr);
  return buf;
}

using Resolver = std::function<Napi::Value(Napi::Env)>;

/** Runs `work` on the thread pool; what it returns builds the value the promise resolves to. */
class Job : public Napi::AsyncWorker {
 public:
  Job(Napi::Env env, std::function<Resolver()> work)
      : Napi::AsyncWorker(env), work_(std::move(work)), deferred_(Napi::Promise::Deferred::New(env)) {}

  Napi::Promise Start() {
    auto promise = deferred_.Promise();
    Queue();
    return promise;
  }

  /** Keeps a buffer alive while the job reads it. */
  void Hold(Napi::Object value) { held_ = Napi::Persistent(value); }

 protected:
  void Execute() override {
    try {
      resolver_ = work_();
    } catch (const Failure& f) {
      hr_ = f.hr;
      SetError(f.what + " " + Hex(f.hr));
    } catch (const winrt::hresult_error& e) {
      hr_ = e.code();
      SetError(winrt::to_string(e.message()) + " " + Hex(hr_));
    } catch (const std::exception& e) {
      hr_ = E_FAIL;
      SetError(e.what());
    }
  }

  void OnOK() override {
    Napi::Env env = Env();
    deferred_.Resolve(resolver_ ? resolver_(env) : env.Undefined());
  }

  void OnError(const Napi::Error& error) override {
    Napi::Object e = error.Value();
    e.Set("hresult", Hex(hr_));
    deferred_.Reject(e);
  }

 private:
  std::function<Resolver()> work_;
  Napi::Promise::Deferred deferred_;
  Napi::ObjectReference held_;
  Resolver resolver_;
  HRESULT hr_ = S_OK;
};

Resolver None() { return nullptr; }

/** The sync root manager is WinRT; a pool thread joins the apartment only for the call. */
struct Apartment {
  Apartment() { winrt::init_apartment(winrt::apartment_type::multi_threaded); }
  ~Apartment() { winrt::uninit_apartment(); }
};

std::string UserSid() {
  HANDLE token;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token))
    throw Failure{HRESULT_FROM_WIN32(GetLastError()), "OpenProcessToken"};
  BYTE buf[256];
  DWORD n = sizeof(buf);
  BOOL ok = GetTokenInformation(token, TokenUser, buf, n, &n);
  CloseHandle(token);
  if (!ok) throw Failure{HRESULT_FROM_WIN32(GetLastError()), "GetTokenInformation"};
  LPWSTR s = nullptr;
  if (!ConvertSidToStringSidW(((TOKEN_USER*)buf)->User.Sid, &s))
    throw Failure{HRESULT_FROM_WIN32(GetLastError()), "ConvertSidToStringSid"};
  std::string out = Narrow(s);
  LocalFree(s);
  return out;
}

LARGE_INTEGER FileTimeFromUnixMs(double ms) {
  LARGE_INTEGER out;
  out.QuadPart = (long long)(ms * 10000.0) + 116444736000000000LL;
  return out;
}

std::string Str(const Napi::Object& o, const char* key) { return o.Get(key).As<Napi::String>().Utf8Value(); }

std::string OptStr(const Napi::Object& o, const char* key) {
  Napi::Value v = o.Get(key);
  return v.IsString() ? v.As<Napi::String>().Utf8Value() : std::string();
}

bool OptBool(const Napi::Object& o, const char* key) {
  Napi::Value v = o.Get(key);
  return v.IsBoolean() && v.As<Napi::Boolean>().Value();
}

std::optional<double> OptNum(const Napi::Object& o, const char* key) {
  Napi::Value v = o.Get(key);
  if (!v.IsNumber()) return std::nullopt;
  return v.As<Napi::Number>().DoubleValue();
}

// ---- sync root ----

/** Provider!SID!Account: the form Windows expects of a sync root id. */
std::wstring SyncRootId(const std::string& provider, const std::string& account) {
  return Wide(provider + "!" + UserSid() + "!" + account);
}

/** The one state Explorer is told of beyond its own icons. */
constexpr int kItemStateId = 1;

/**
 * `shell`: registers with Windows Explorer too, which adds the folder to its navigation pane.
 * Without it only the folder itself is marked, which leaves nothing behind in the registry.
 */
Napi::Value RegisterRoot(const Napi::CallbackInfo& info) {
  Napi::Object o = info[0].As<Napi::Object>();
  std::wstring root = Wide(Str(o, "root"));
  std::string provider = Str(o, "provider");
  std::string account = Str(o, "account");
  std::wstring display = Wide(OptStr(o, "displayName"));
  std::wstring version = Wide(Str(o, "version"));
  std::wstring icon = Wide(OptStr(o, "icon"));
  std::wstring state_name = Wide(OptStr(o, "stateName"));
  bool shell = OptBool(o, "shell");

  auto* job = new Job(info.Env(), [=]() -> Resolver {
    if (!shell) {
      std::wstring name = Wide(provider);
      CF_SYNC_REGISTRATION reg{};
      reg.StructSize = sizeof(reg);
      reg.ProviderName = name.c_str();
      reg.ProviderVersion = version.c_str();
      CF_SYNC_POLICIES pol{};
      pol.StructSize = sizeof(pol);
      pol.Hydration.Primary = CF_HYDRATION_POLICY_FULL;
      pol.Population.Primary = CF_POPULATION_POLICY_ALWAYS_FULL;
      pol.InSync = CF_INSYNC_POLICY_TRACK_FILE_LAST_WRITE_TIME;
      Check(CfRegisterSyncRoot(root.c_str(), &reg, &pol, CF_REGISTER_FLAG_DISABLE_ON_DEMAND_POPULATION_ON_ROOT),
            "CfRegisterSyncRoot");
      return None();
    }
    Apartment apartment;
    auto folder = StorageFolder::GetFolderFromPathAsync(root).get();
    StorageProviderSyncRootInfo root_info;
    root_info.Id(SyncRootId(provider, account));
    root_info.Path(folder);
    root_info.DisplayNameResource(display);
    root_info.IconResource(icon);
    root_info.HydrationPolicy(StorageProviderHydrationPolicy::Full);
    root_info.HydrationPolicyModifier(StorageProviderHydrationPolicyModifier::AutoDehydrationAllowed);
    root_info.PopulationPolicy(StorageProviderPopulationPolicy::AlwaysFull);
    // Only a file's content. With folders tracked, adding a file would mark its folder out of sync
    // for good, since nothing here uploads a folder's date.
    root_info.InSyncPolicy(StorageProviderInSyncPolicy::FileLastWriteTime);
    root_info.HardlinkPolicy(StorageProviderHardlinkPolicy::None);
    root_info.ShowSiblingsAsGroup(false);
    root_info.Version(version);
    root_info.Context(winrt::Windows::Security::Cryptography::CryptographicBuffer::ConvertStringToBinary(
        Wide(account), winrt::Windows::Security::Cryptography::BinaryStringEncoding::Utf8));
    if (!state_name.empty()) {
      StorageProviderItemPropertyDefinition definition;
      definition.Id(kItemStateId);
      definition.DisplayNameResource(state_name);
      root_info.StorageProviderItemPropertyDefinitions().Append(definition);
    }
    StorageProviderSyncRootManager::Register(root_info);
    return None();
  });
  return job->Start();
}

Napi::Value UnregisterRoot(const Napi::CallbackInfo& info) {
  Napi::Object o = info[0].As<Napi::Object>();
  std::wstring root = Wide(OptStr(o, "root"));
  std::string provider = OptStr(o, "provider");
  std::string account = OptStr(o, "account");
  bool shell = OptBool(o, "shell");
  auto* job = new Job(info.Env(), [=]() -> Resolver {
    if (shell) {
      Apartment apartment;
      StorageProviderSyncRootManager::Unregister(SyncRootId(provider, account));
    } else {
      Check(CfUnregisterSyncRoot(root.c_str()), "CfUnregisterSyncRoot");
    }
    return None();
  });
  return job->Start();
}

// ---- connection: what Windows asks for ----

struct Connection {
  CF_CONNECTION_KEY key{};
  Napi::ThreadSafeFunction events;
};

std::mutex g_connections_lock;
std::unordered_map<LONGLONG, std::shared_ptr<Connection>> g_connections;

struct Event {
  const char* type;
  std::string path;
  std::string identity;
  LONGLONG transfer;
  LONGLONG offset = 0;
  LONGLONG length = 0;
  LONGLONG fileSize = 0;
  std::string process;
};

std::string AbsolutePath(const CF_CALLBACK_INFO* info) {
  std::string volume = Narrow(info->VolumeDosName);
  return volume + Narrow(info->NormalizedPath);
}

void Emit(const CF_CALLBACK_INFO* info, Event event) {
  auto* ctx = static_cast<Connection*>(info->CallbackContext);
  auto* owned = new Event(std::move(event));
  auto status = ctx->events.NonBlockingCall(owned, [](Napi::Env env, Napi::Function fn, Event* e) {
    if (static_cast<napi_env>(env) == nullptr) {
      delete e;
      return;
    }
    Napi::Object o = Napi::Object::New(env);
    o.Set("type", e->type);
    o.Set("path", e->path);
    o.Set("identity", e->identity);
    o.Set("transferKey", std::to_string(e->transfer));
    o.Set("offset", (double)e->offset);
    o.Set("length", (double)e->length);
    o.Set("fileSize", (double)e->fileSize);
    o.Set("process", e->process);
    delete e;
    fn.Call({o});
  });
  if (status != napi_ok) delete owned;
}

std::string Identity(const CF_CALLBACK_INFO* info) {
  return std::string(static_cast<const char*>(info->FileIdentity), info->FileIdentityLength);
}

void CALLBACK OnFetch(const CF_CALLBACK_INFO* info, const CF_CALLBACK_PARAMETERS* p) {
  Emit(info, {"fetch", AbsolutePath(info), Identity(info), info->TransferKey.QuadPart,
              p->FetchData.RequiredFileOffset.QuadPart, p->FetchData.RequiredLength.QuadPart,
              info->FileSize.QuadPart,
              info->ProcessInfo ? Narrow(info->ProcessInfo->ImagePath) : std::string()});
}

void CALLBACK OnCancel(const CF_CALLBACK_INFO* info, const CF_CALLBACK_PARAMETERS* p) {
  Emit(info, {"cancel", AbsolutePath(info), Identity(info), info->TransferKey.QuadPart,
              p->Cancel.FetchData.FileOffset.QuadPart, p->Cancel.FetchData.Length.QuadPart,
              info->FileSize.QuadPart});
}

/**
 * The folder is watched and compared, so renames and deletes need no answer here. Without these
 * two Windows waits for nothing and lets them through, also while the app is closed.
 */
Napi::Value Connect(const Napi::CallbackInfo& info) {
  std::wstring root = Wide(info[0].As<Napi::String>().Utf8Value());
  auto connection = std::make_shared<Connection>();
  connection->events = Napi::ThreadSafeFunction::New(info.Env(), info[1].As<Napi::Function>(), "cloudfiles", 0, 1);
  // Must not keep the process alive; the app decides when it quits.
  connection->events.Unref(info.Env());
  auto* job = new Job(info.Env(), [root, connection]() -> Resolver {
    static const CF_CALLBACK_REGISTRATION table[] = {
        {CF_CALLBACK_TYPE_FETCH_DATA, OnFetch},
        {CF_CALLBACK_TYPE_CANCEL_FETCH_DATA, OnCancel},
        CF_CALLBACK_REGISTRATION_END,
    };
    HRESULT hr = CfConnectSyncRoot(root.c_str(), table, connection.get(),
                                   CF_CONNECT_FLAG_REQUIRE_PROCESS_INFO | CF_CONNECT_FLAG_REQUIRE_FULL_FILE_PATH,
                                   &connection->key);
    if (FAILED(hr)) connection->events.Release();
    Check(hr, "CfConnectSyncRoot");
    LONGLONG key = connection->key.Internal;
    {
      std::lock_guard<std::mutex> lock(g_connections_lock);
      g_connections[key] = connection;
    }
    return [key](Napi::Env env) -> Napi::Value { return Napi::String::New(env, std::to_string(key)); };
  });
  return job->Start();
}

LONGLONG ParseKey(const Napi::Value& v) { return _strtoi64(v.As<Napi::String>().Utf8Value().c_str(), nullptr, 10); }

Napi::Value Disconnect(const Napi::CallbackInfo& info) {
  LONGLONG key = ParseKey(info[0]);
  auto* job = new Job(info.Env(), [key]() -> Resolver {
    std::shared_ptr<Connection> connection;
    {
      std::lock_guard<std::mutex> lock(g_connections_lock);
      auto it = g_connections.find(key);
      if (it == g_connections.end()) return None();
      connection = it->second;
      g_connections.erase(it);
    }
    HRESULT hr = CfDisconnectSyncRoot(connection->key);
    connection->events.Release();
    Check(hr, "CfDisconnectSyncRoot");
    return None();
  });
  return job->Start();
}

CF_CONNECTION_KEY ToConnectionKey(LONGLONG key) {
  CF_CONNECTION_KEY out{};
  out.Internal = key;
  return out;
}

/** Bytes for a fetch. `offset` is 4 KB aligned; so is the length, except at the end of the file. */
Napi::Value Transfer(const Napi::CallbackInfo& info) {
  LONGLONG key = ParseKey(info[0]);
  LONGLONG transfer = ParseKey(info[1]);
  Napi::Buffer<uint8_t> data = info[2].As<Napi::Buffer<uint8_t>>();
  LONGLONG offset = (LONGLONG)info[3].As<Napi::Number>().DoubleValue();
  LONGLONG total = (LONGLONG)info[4].As<Napi::Number>().DoubleValue();
  uint8_t* bytes = data.Data();
  LONGLONG length = (LONGLONG)data.Length();
  auto* job = new Job(info.Env(), [=]() -> Resolver {
    CF_TRANSFER_KEY tk;
    tk.QuadPart = transfer;
    CF_OPERATION_INFO op{sizeof(op), CF_OPERATION_TYPE_TRANSFER_DATA, ToConnectionKey(key), tk};
    CF_OPERATION_PARAMETERS params{};
    params.ParamSize = CF_OP_PARAM_SIZE(TransferData);
    params.TransferData.CompletionStatus = STATUS_SUCCESS;
    params.TransferData.Buffer = bytes;
    params.TransferData.Offset.QuadPart = offset;
    params.TransferData.Length.QuadPart = length;
    Check(CfExecute(&op, &params), "CfExecute");
    LARGE_INTEGER all, done;
    all.QuadPart = total;
    done.QuadPart = offset + length;
    // Only drives the progress Windows shows; a failure here changes nothing.
    CfReportProviderProgress(ToConnectionKey(key), tk, all, done);
    return None();
  });
  job->Hold(data);
  return job->Start();
}

/** A fetch cannot be served: the program reading the file gets a read error. */
Napi::Value TransferFail(const Napi::CallbackInfo& info) {
  LONGLONG key = ParseKey(info[0]);
  LONGLONG transfer = ParseKey(info[1]);
  LONGLONG offset = (LONGLONG)info[2].As<Napi::Number>().DoubleValue();
  LONGLONG length = (LONGLONG)info[3].As<Napi::Number>().DoubleValue();
  NTSTATUS status = (NTSTATUS)info[4].As<Napi::Number>().Uint32Value();
  auto* job = new Job(info.Env(), [=]() -> Resolver {
    CF_TRANSFER_KEY tk;
    tk.QuadPart = transfer;
    CF_OPERATION_INFO op{sizeof(op), CF_OPERATION_TYPE_TRANSFER_DATA, ToConnectionKey(key), tk};
    CF_OPERATION_PARAMETERS params{};
    params.ParamSize = CF_OP_PARAM_SIZE(TransferData);
    params.TransferData.CompletionStatus = status;
    params.TransferData.Offset.QuadPart = offset;
    params.TransferData.Length.QuadPart = length;
    Check(CfExecute(&op, &params), "CfExecute");
    return None();
  });
  return job->Start();
}

// ---- placeholders ----

struct NewItem {
  std::wstring name;
  std::string identity;
  LONGLONG size;
  double mtimeMs;
  bool folder;
};

/**
 * `items` go into the existing folder `parent`. Resolves to one HRESULT string per item, however
 * the call fails: a bad item has its own, and a call that wrote none gives each item its code.
 */
Napi::Value CreatePlaceholders(const Napi::CallbackInfo& info) {
  std::wstring parent = Wide(info[0].As<Napi::String>().Utf8Value());
  Napi::Array list = info[1].As<Napi::Array>();
  auto items = std::make_shared<std::vector<NewItem>>();
  for (uint32_t i = 0; i < list.Length(); i++) {
    Napi::Object o = list.Get(i).As<Napi::Object>();
    items->push_back({Wide(Str(o, "name")), Str(o, "identity"), (LONGLONG)OptNum(o, "size").value_or(0),
                      OptNum(o, "mtimeMs").value_or(0), OptBool(o, "folder")});
  }
  auto* job = new Job(info.Env(), [parent, items]() -> Resolver {
    // Not a code Windows gives an item, so it shows which ones the call never reached.
    constexpr HRESULT kNotReached = E_PENDING;
    std::vector<CF_PLACEHOLDER_CREATE_INFO> infos(items->size());
    for (size_t i = 0; i < items->size(); i++) {
      const NewItem& item = (*items)[i];
      CF_PLACEHOLDER_CREATE_INFO& c = infos[i];
      c.Result = kNotReached;
      c.RelativeFileName = item.name.c_str();
      LARGE_INTEGER when = FileTimeFromUnixMs(item.mtimeMs);
      c.FsMetadata.FileSize.QuadPart = item.folder ? 0 : item.size;
      c.FsMetadata.BasicInfo.CreationTime = when;
      c.FsMetadata.BasicInfo.LastWriteTime = when;
      c.FsMetadata.BasicInfo.LastAccessTime = when;
      c.FsMetadata.BasicInfo.ChangeTime = when;
      c.FsMetadata.BasicInfo.FileAttributes = item.folder ? FILE_ATTRIBUTE_DIRECTORY : FILE_ATTRIBUTE_NORMAL;
      c.FileIdentity = item.identity.data();
      c.FileIdentityLength = (DWORD)item.identity.size();
      c.Flags = CF_PLACEHOLDER_CREATE_FLAG_MARK_IN_SYNC |
                (item.folder ? CF_PLACEHOLDER_CREATE_FLAG_DISABLE_ON_DEMAND_POPULATION : CF_PLACEHOLDER_CREATE_FLAG_NONE);
    }
    DWORD done = 0;
    HRESULT hr = infos.empty()
                     ? S_OK
                     : CfCreatePlaceholders(parent.c_str(), infos.data(), (DWORD)infos.size(), CF_CREATE_FLAG_NONE, &done);
    auto results = std::make_shared<std::vector<std::string>>();
    for (const auto& c : infos) results->push_back(Hex(c.Result == kNotReached ? (FAILED(hr) ? hr : E_UNEXPECTED) : c.Result));
    return [results](Napi::Env env) -> Napi::Value {
      Napi::Array out = Napi::Array::New(env, results->size());
      for (size_t i = 0; i < results->size(); i++) out.Set((uint32_t)i, (*results)[i]);
      return out;
    };
  });
  return job->Start();
}

HANDLE OpenForAttributes(const std::wstring& path, DWORD access) {
  HANDLE h = CreateFileW(path.c_str(), access, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
                         OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, nullptr);
  if (h == INVALID_HANDLE_VALUE) throw Failure{HRESULT_FROM_WIN32(GetLastError()), "CreateFile"};
  return h;
}

/** `{ placeholder, inSync, identity, size, onDisk, pin }`; `placeholder` false for a plain file. */
Napi::Value Info(const Napi::CallbackInfo& info) {
  std::wstring path = Wide(info[0].As<Napi::String>().Utf8Value());
  auto* job = new Job(info.Env(), [path]() -> Resolver {
    WIN32_FILE_ATTRIBUTE_DATA a{};
    if (!GetFileAttributesExW(path.c_str(), GetFileExInfoStandard, &a))
      throw Failure{HRESULT_FROM_WIN32(GetLastError()), "GetFileAttributesEx"};
    DWORD high = 0;
    DWORD low = GetCompressedFileSizeW(path.c_str(), &high);
    LONGLONG onDisk = (a.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) ? 0 : (((LONGLONG)high << 32) | low);
    LONGLONG size = ((LONGLONG)a.nFileSizeHigh << 32) | a.nFileSizeLow;
    HANDLE h = OpenForAttributes(path, FILE_READ_ATTRIBUTES);
    std::vector<char> buf(sizeof(CF_PLACEHOLDER_BASIC_INFO) + CF_PLACEHOLDER_MAX_FILE_IDENTITY_LENGTH);
    DWORD ret = 0;
    HRESULT hr = CfGetPlaceholderInfo(h, CF_PLACEHOLDER_INFO_BASIC, buf.data(), (DWORD)buf.size(), &ret);
    CloseHandle(h);
    if (FAILED(hr) && hr != HRESULT_FROM_WIN32(ERROR_NOT_A_CLOUD_FILE)) Check(hr, "CfGetPlaceholderInfo");
    bool placeholder = SUCCEEDED(hr);
    bool inSync = false;
    int pin = 0;
    std::string identity;
    if (placeholder) {
      auto* b = reinterpret_cast<CF_PLACEHOLDER_BASIC_INFO*>(buf.data());
      inSync = b->InSyncState == CF_IN_SYNC_STATE_IN_SYNC;
      pin = (int)b->PinState;
      identity.assign(reinterpret_cast<const char*>(b->FileIdentity), b->FileIdentityLength);
    }
    return [=](Napi::Env env) -> Napi::Value {
      Napi::Object o = Napi::Object::New(env);
      o.Set("placeholder", placeholder);
      o.Set("inSync", inSync);
      o.Set("identity", identity);
      o.Set("size", (double)size);
      o.Set("onDisk", (double)onDisk);
      o.Set("pin", pin);
      return o;
    };
  });
  return job->Start();
}

/**
 * The file's attributes, also those of another provider's placeholder. This asks the file system
 * about the name and never opens the file, so nothing is downloaded.
 */
Napi::Value Attributes(const Napi::CallbackInfo& info) {
  std::wstring path = Wide(info[0].As<Napi::String>().Utf8Value());
  auto* job = new Job(info.Env(), [path]() -> Resolver {
    DWORD attributes = GetFileAttributesW(path.c_str());
    if (attributes == INVALID_FILE_ATTRIBUTES)
      throw Failure{HRESULT_FROM_WIN32(GetLastError()), "GetFileAttributes"};
    return [attributes](Napi::Env env) -> Napi::Value { return Napi::Number::New(env, attributes); };
  });
  return job->Start();
}

/**
 * The server has something new: `size`, `mtimeMs`, and with `dehydrate` the bytes here go, so the
 * next read asks for the new version. Marks it in sync.
 */
Napi::Value UpdatePlaceholder(const Napi::CallbackInfo& info) {
  std::wstring path = Wide(info[0].As<Napi::String>().Utf8Value());
  Napi::Object o = info[1].As<Napi::Object>();
  std::string identity = OptStr(o, "identity");
  std::optional<double> size = OptNum(o, "size");
  std::optional<double> mtimeMs = OptNum(o, "mtimeMs");
  bool dehydrate = OptBool(o, "dehydrate");
  bool verify = OptBool(o, "verifyInSync");
  auto* job = new Job(info.Env(), [=]() -> Resolver {
    WIN32_FILE_ATTRIBUTE_DATA current{};
    if (!GetFileAttributesExW(path.c_str(), GetFileExInfoStandard, &current))
      throw Failure{HRESULT_FROM_WIN32(GetLastError()), "GetFileAttributesEx"};
    HANDLE h = OpenForAttributes(path, FILE_WRITE_ATTRIBUTES);
    CF_FS_METADATA meta{};
    // Zero leaves them. Anything else replaces them, also the marks Explorer's commands set.
    meta.BasicInfo.FileAttributes = 0;
    if (mtimeMs) {
      LARGE_INTEGER when = FileTimeFromUnixMs(*mtimeMs);
      meta.BasicInfo.LastWriteTime = when;
      meta.BasicInfo.ChangeTime = when;
    }
    // The metadata replaces the size too, so a new date alone carries the current one.
    meta.FileSize.QuadPart =
        size ? (LONGLONG)*size : (((LONGLONG)current.nFileSizeHigh << 32) | current.nFileSizeLow);
    CF_FILE_RANGE all{};
    all.StartingOffset.QuadPart = 0;
    all.Length.QuadPart = -1;
    USN usn = 0;
    CF_UPDATE_FLAGS flags = CF_UPDATE_FLAG_MARK_IN_SYNC;
    if (dehydrate) flags |= CF_UPDATE_FLAG_DEHYDRATE;
    if (verify) flags |= CF_UPDATE_FLAG_VERIFY_IN_SYNC;
    HRESULT hr = CfUpdatePlaceholder(h, (size || mtimeMs) ? &meta : nullptr, identity.empty() ? nullptr : identity.data(),
                                     (DWORD)identity.size(), dehydrate ? &all : nullptr, dehydrate ? 1 : 0, flags, &usn,
                                     nullptr);
    CloseHandle(h);
    Check(hr, "CfUpdatePlaceholder");
    return None();
  });
  return job->Start();
}

/** A file or folder made here becomes one of ours once the server has it. */
Napi::Value ConvertToPlaceholder(const Napi::CallbackInfo& info) {
  std::wstring path = Wide(info[0].As<Napi::String>().Utf8Value());
  std::string identity = info[1].As<Napi::String>().Utf8Value();
  auto* job = new Job(info.Env(), [=]() -> Resolver {
    HANDLE h = OpenForAttributes(path, FILE_WRITE_ATTRIBUTES);
    bool directory = (GetFileAttributesW(path.c_str()) & FILE_ATTRIBUTE_DIRECTORY) != 0;
    CF_CONVERT_FLAGS flags = CF_CONVERT_FLAG_MARK_IN_SYNC;
    if (directory) flags |= CF_CONVERT_FLAG_ALWAYS_FULL;
    HRESULT hr = CfConvertToPlaceholder(h, identity.data(), (DWORD)identity.size(), flags, nullptr, nullptr);
    CloseHandle(h);
    Check(hr, "CfConvertToPlaceholder");
    return None();
  });
  return job->Start();
}

/** Frees the space a downloaded file takes; the next read downloads it again. */
Napi::Value Dehydrate(const Napi::CallbackInfo& info) {
  std::wstring path = Wide(info[0].As<Napi::String>().Utf8Value());
  auto* job = new Job(info.Env(), [=]() -> Resolver {
    HANDLE h = OpenForAttributes(path, FILE_WRITE_ATTRIBUTES);
    LARGE_INTEGER from{}, length{};
    length.QuadPart = -1;
    HRESULT hr = CfDehydratePlaceholder(h, from, length, CF_DEHYDRATE_FLAG_NONE, nullptr);
    CloseHandle(h);
    Check(hr, "CfDehydratePlaceholder");
    return None();
  });
  return job->Start();
}

/**
 * Brings the whole file here. Waits until it is, so it holds a pool thread as long as the download
 * takes: the caller keeps these few, since the bytes need a pool thread to arrive.
 */
Napi::Value Hydrate(const Napi::CallbackInfo& info) {
  std::wstring path = Wide(info[0].As<Napi::String>().Utf8Value());
  auto* job = new Job(info.Env(), [=]() -> Resolver {
    HANDLE h = OpenForAttributes(path, FILE_READ_ATTRIBUTES);
    LARGE_INTEGER from{}, length{};
    length.QuadPart = MAXLONGLONG;
    HRESULT hr = CfHydratePlaceholder(h, from, length, CF_HYDRATE_FLAG_NONE, nullptr);
    CloseHandle(h);
    Check(hr, "CfHydratePlaceholder");
    return None();
  });
  return job->Start();
}

/** `state`: 0 unspecified, 1 pinned, 2 unpinned. `recurse`: everything inside a folder too. */
Napi::Value SetPin(const Napi::CallbackInfo& info) {
  std::wstring path = Wide(info[0].As<Napi::String>().Utf8Value());
  int state = info[1].As<Napi::Number>().Int32Value();
  bool recurse = info.Length() > 2 && info[2].IsBoolean() && info[2].As<Napi::Boolean>().Value();
  auto* job = new Job(info.Env(), [=]() -> Resolver {
    HANDLE h = OpenForAttributes(path, FILE_WRITE_ATTRIBUTES);
    HRESULT hr = CfSetPinState(h, static_cast<CF_PIN_STATE>(state),
                               recurse ? CF_SET_PIN_FLAG_RECURSE : CF_SET_PIN_FLAG_NONE, nullptr);
    CloseHandle(h);
    Check(hr, "CfSetPinState");
    return None();
  });
  return job->Start();
}

/**
 * The icon and text Explorer shows next to a file, beside its own status. An empty `text` takes it
 * off. Only in a root registered with Explorer, and it never opens the file's content.
 */
Napi::Value SetItemState(const Napi::CallbackInfo& info) {
  std::wstring path = Wide(info[0].As<Napi::String>().Utf8Value());
  std::wstring text = Wide(info[1].As<Napi::String>().Utf8Value());
  std::wstring icon = Wide(info[2].As<Napi::String>().Utf8Value());
  auto* job = new Job(info.Env(), [=]() -> Resolver {
    Apartment apartment;
    DWORD attributes = GetFileAttributesW(path.c_str());
    if (attributes == INVALID_FILE_ATTRIBUTES)
      throw Failure{HRESULT_FROM_WIN32(GetLastError()), "GetFileAttributes"};
    IStorageItem item{nullptr};
    if (attributes & FILE_ATTRIBUTE_DIRECTORY) {
      item = StorageFolder::GetFolderFromPathAsync(path).get();
    } else {
      item = StorageFile::GetFileFromPathAsync(path).get();
    }
    auto properties = winrt::single_threaded_vector<StorageProviderItemProperty>();
    if (!text.empty()) {
      StorageProviderItemProperty property;
      property.Id(kItemStateId);
      property.Value(text);
      property.IconResource(icon);
      properties.Append(property);
    }
    StorageProviderItemProperties::SetAsync(item, properties).get();
    return None();
  });
  return job->Start();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("registerRoot", Napi::Function::New(env, RegisterRoot));
  exports.Set("unregisterRoot", Napi::Function::New(env, UnregisterRoot));
  exports.Set("connect", Napi::Function::New(env, Connect));
  exports.Set("disconnect", Napi::Function::New(env, Disconnect));
  exports.Set("transfer", Napi::Function::New(env, Transfer));
  exports.Set("transferFail", Napi::Function::New(env, TransferFail));
  exports.Set("createPlaceholders", Napi::Function::New(env, CreatePlaceholders));
  exports.Set("info", Napi::Function::New(env, Info));
  exports.Set("attributes", Napi::Function::New(env, Attributes));
  exports.Set("updatePlaceholder", Napi::Function::New(env, UpdatePlaceholder));
  exports.Set("convertToPlaceholder", Napi::Function::New(env, ConvertToPlaceholder));
  exports.Set("dehydrate", Napi::Function::New(env, Dehydrate));
  exports.Set("hydrate", Napi::Function::New(env, Hydrate));
  exports.Set("setPin", Napi::Function::New(env, SetPin));
  exports.Set("setItemState", Napi::Function::New(env, SetItemState));
  return exports;
}

}  // namespace

NODE_API_MODULE(cloudfiles, Init)
