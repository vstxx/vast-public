using System.Buffers.Binary;
using System.Text;
using System.Text.Json;

const int MaxIncomingBytes = 64 * 1024 * 1024;
var input = Console.OpenStandardInput();
var output = Console.OpenStandardOutput();
var evidencePath = Environment.GetEnvironmentVariable("VAST_NATIVE_TEST_EVIDENCE");

if (!string.IsNullOrWhiteSpace(evidencePath))
{
    var safeArgs = args.Select(arg => arg.StartsWith("chrome-extension://", StringComparison.Ordinal)
        ? arg
        : arg.StartsWith("--parent-window=", StringComparison.Ordinal) ? arg : "<redacted>");
    await AppendEvidence(evidencePath, JsonSerializer.Serialize(new { eventName = "started", args = safeArgs }) + Environment.NewLine);
}

while (true)
{
    var header = new byte[4];
    if (!await ReadExact(input, header)) break;
    var length = BinaryPrimitives.ReadUInt32LittleEndian(header);
    if (length > MaxIncomingBytes) return 2;
    var payload = new byte[length];
    if (!await ReadExact(input, payload)) return 3;

    using var document = JsonDocument.Parse(payload);
    var root = document.RootElement;
    var kind = root.TryGetProperty("kind", out var kindValue) ? kindValue.GetString() : null;
    if (kind == "exit") return 7;

    if (kind == "coalesced")
    {
        var first = Frame(new { kind = "coalesced", sequence = 1 });
        var second = Frame(new { kind = "coalesced", sequence = 2 });
        await output.WriteAsync(first.Concat(second).ToArray());
        await output.FlushAsync();
        continue;
    }

    var text = root.TryGetProperty("text", out var textValue) ? textValue.GetString() : null;
    var response = Frame(new { kind = kind ?? "unknown", text, utf8Bytes = payload.Length });
    if (kind == "fragmented")
    {
        await output.WriteAsync(response.AsMemory(0, 2));
        await output.FlushAsync();
        await Task.Delay(40);
        await output.WriteAsync(response.AsMemory(2));
    }
    else
    {
        await output.WriteAsync(response);
    }
    await output.FlushAsync();
}

return 0;

static async Task<bool> ReadExact(Stream input, byte[] buffer)
{
    var offset = 0;
    while (offset < buffer.Length)
    {
        var read = await input.ReadAsync(buffer.AsMemory(offset));
        if (read == 0) return offset == 0 ? false : throw new EndOfStreamException();
        offset += read;
    }
    return true;
}

static byte[] Frame(object value)
{
    var payload = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(value));
    var frame = new byte[4 + payload.Length];
    BinaryPrimitives.WriteUInt32LittleEndian(frame, checked((uint)payload.Length));
    payload.CopyTo(frame, 4);
    return frame;
}

static async Task AppendEvidence(string path, string line)
{
    // sendNativeMessage and connectNative deliberately start separate hosts at
    // nearly the same time. File.AppendAllText takes an exclusive Windows file
    // lock, so retry the tiny diagnostic write instead of letting the fixture
    // process crash before it can exercise Native Messaging.
    for (var attempt = 0; attempt < 50; attempt++)
    {
        try
        {
            File.AppendAllText(path, line);
            return;
        }
        catch (IOException) when (attempt < 49)
        {
            await Task.Delay(10);
        }
    }
}
