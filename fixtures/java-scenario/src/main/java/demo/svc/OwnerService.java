package demo.svc;

public class OwnerService {

    public String findOwner(int id) { return "o" + id; }

    protected boolean exists(int id) { return true; }

    private void cacheWarm() {}
}
